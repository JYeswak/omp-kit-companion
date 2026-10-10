import { expect, test } from "bun:test";
import { flushPending, type FleetIo, type FleetProcess } from "../../src/fleet-flywheel-doctor.ts";
import type { AdmissionInput } from "../../src/actuator-admission.ts";

// ompkit-bj08.5: pause/resend negatives through the real flush branch.
// Screen recipe mirrors the captured OMP renders in fleet-flywheel-doctor.test.ts.

const NOW = Date.parse("2026-10-09T18:00:00Z");
const MIN = 60_000;
const RULE = "─".repeat(40);
const TOOL_BOX = ["│ 12                                       │", "│ ⟦Timeout: 300s⟧                          │", "╰──────────────────────────────────────────╯"];
const STATUS_IDLE = " π · ◔ GPT-6-Luna · 📁 …panion · ⑂ main · ◫ 15.4%/272K ⟲ · S0.00";
const STEER_BAND = [" Steering · 1", "   1. Read-only reviewer. Please investigate.", "   └ ⌥↑ to edit"];
const IDLE_BAND = [...TOOL_BOX, ...STEER_BAND, `${RULE} Run bash echo sleep loop ─`, "❯", RULE, STATUS_IDLE, ""].join("\n");

type SentKeys = { pane: string; keys: string[] }[];
type FakePane = { index: number; omp: boolean; text: string; idleMin: number; then?: string };

function directorIo(panes: FakePane[], sent: SentKeys, tmuxCalls: string[][]): FleetIo {
	const listing = panes.map((pane, n) => `cfsios\t0\t${pane.index}\t${1000 + n}\t%${100 + n}`).join("\n");
	const find = (target: string) => panes.find((candidate, n) => target === `%${100 + n}`);
	return {
		nowMs: () => NOW,
		tmux: (args) => {
			tmuxCalls.push([...args]);
			if (args[0] === "list-panes") return listing;
			const pane = find(args[0] === "send-keys" ? args[2]! : args[args.length - 1]!);
			if (!pane) return null;
			if (args[0] === "send-keys") {
				sent.push({ pane: args[2]!, keys: args.slice(3) });
				if (pane.then !== undefined) pane.text = pane.then;
				return "";
			}
			return pane.text;
		},
		processes: (): FleetProcess[] => panes.flatMap((pane, n) => [{ pid: 2000 + n, ppid: 1000 + n, args: "bun /Users/x/.bun/bin/omp --profile claude" }]),
		openSessionFiles: (pids) => new Map(pids.map((pid) => [pid, [`/Users/x/.omp/profiles/claude/agent/sessions/-repo/${pid}.jsonl`]])),
		mtimeMs: (path) => {
			const pane = panes[Number(/(\d+)\.jsonl$/.exec(path)![1]) - 2000]!;
			return NOW - pane.idleMin * MIN;
		},
		sleep: () => {},
		mailSends: () => [],
		readFile: () => null,
		git: () => null,
	};
}

function snapshot(authority: "ACTIVE" | "PAUSED", resend?: AdmissionInput["resend"]): AdmissionInput {
	return {
		launcherBinding: "none",
		authority,
		authorityConfirmed: true,
		authorityGeneration: "gen-7",
		launchers: [],
		keeper: null,
		packet: { action: "flush", ownedAction: "flush", generation: "gen-7" },
		governedActions: ["flush"],
		...(resend === undefined ? {} : { resend }),
	};
}

function flushFixture() {
	const sent: SentKeys = [];
	const tmuxCalls: string[][] = [];
	const panes: FakePane[] = [{ index: 1, omp: true, text: IDLE_BAND, idleMin: 3, then: IDLE_BAND }];
	return { sent, tmuxCalls, io: directorIo(panes, sent, tmuxCalls) };
}

test("[b] planted: paused authority refuses flush with zero keys", () => {
	const run = flushFixture();
	const report = flushPending(run.io, true, snapshot("PAUSED"));
	expect(report.panes.map((pane) => pane.result)).toEqual(["ADMISSION_REFUSED"]);
	expect(run.sent).toEqual([]);
	expect(run.tmuxCalls.filter((argv) => argv[0] === "send-keys")).toEqual([]);
});

test("[b] planted: STARTED without spinner authorizes no resend", () => {
	const run = flushFixture();
	const report = flushPending(run.io, true, snapshot("ACTIVE", { flushResult: "STARTED", spinnerVisible: false }));
	expect(report.panes.map((pane) => pane.result)).toEqual(["ADMISSION_REFUSED"]);
	expect(run.sent).toEqual([]);
	expect(run.tmuxCalls.filter((argv) => argv[0] === "send-keys")).toEqual([]);
});

test("[b] admitted flush sends keys through the real branch", () => {
	const run = flushFixture();
	const report = flushPending(run.io, true, snapshot("ACTIVE"));
	expect(run.sent.length).toBeGreaterThan(0);
	expect(report.panes[0]?.keys_sent.length).toBeGreaterThan(0);
});
