import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { RESTORE_NOTICE_WINDOW_S, restoreNotice, restoreNoticeDue } from "../../src/imessage-bridge.ts";
import { projectStatus } from "../../src/project-add.ts";

const source = resolve(import.meta.dir, "../..");
const scratchRoot = join(source, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = ownedTmp("imessage-restore-notice-tests", { root: scratchRoot });
afterAll(() => scratch.cleanup());

const HANDLE = "+15551234567";

/** Same imsg stub shape as imessage-bridge.test.ts: send appends to outbox.jsonl and counts. */
function writeStubBin(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "imsg"), `#!/bin/sh
state="\${IMSG_STUB_STATE:?}"
mode="$1"
shift
case "$mode" in
	chats) cat "$state/chats.json";;
	history) cat "$state/history.json";;
	send)
		to=""
		text=""
		while [ $# -gt 0 ]; do
			case "$1" in
				--to) to="$2"; shift 2;;
				--text) text="$2"; shift 2;;
				*) shift;;
			esac
		done
		n=1
		if [ -f "$state/send-count" ]; then n=$(( $(cat "$state/send-count") + 1 )); fi
		printf '%s' "$n" > "$state/send-count"
		TO="$to" TEXT="$text" OUT="$state/outbox.jsonl" python3 -c 'import json,os; open(os.environ["OUT"],"a").write(json.dumps({"to":os.environ["TO"],"text":os.environ["TEXT"]})+"\\n")'
		printf '{"status":"sent","guid":"stub-restore-%s"}\\n' "$n"
		;;
	*) printf '{"error":"unknown mode"}\\n'; exit 1;;
esac
`);
	chmodSync(join(dir, "imsg"), 0o755);
}

function makeHome(tag: string): { home: string; state: string; imsgBin: string } {
	const home = join(scratch.path, tag);
	const state = join(home, "stub-state");
	mkdirSync(state, { recursive: true });
	const bin = join(home, "bin");
	writeStubBin(bin);
	const jobs = join(home, ".local", "state", "omp-kit", "jobs");
	mkdirSync(jobs, { recursive: true });
	writeFileSync(join(state, "chats.json"), `${JSON.stringify({ id: 7, is_group: false, participants: [HANDLE] })}\n`);
	writeFileSync(join(state, "history.json"), `${JSON.stringify({ guid: "seed-0", sender: HANDLE, text: "(seed)", is_from_me: false, is_group: false })}\n`);
	return { home, state, imsgBin: join(bin, "imsg") };
}

function outbox(state: string): { to: string; text: string }[] {
	let raw = "";
	try {
		raw = readFileSync(join(state, "outbox.jsonl"), "utf8");
	} catch {
		return [];
	}
	return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as { to: string; text: string });
}

const config = (configPath: string) => ({ handle: HANDLE, seat: "leadsession", pane: "tern:5", configPath });

const BOOT_S = 1763046157;
/** A pause the restore made (after boot) and one the owner made the day before (before boot). */
const AFTER_BOOT = new Date((BOOT_S + 600) * 1000).toISOString();
const BEFORE_BOOT = new Date((BOOT_S - 86_400) * 1000).toISOString();

test("RESTORENOTICE1 one paused and one active seat sends exactly one notice naming only the paused seat", async () => {
	const { home, state, imsgBin } = makeHome("paused-and-active");
	const env = { ...process.env as Record<string, string>, IMSG_STUB_STATE: state };
	const first = restoreNotice({
		home, env, config: config(join(home, "fleet-watch.json")), imsgBin, bootTimeS: BOOT_S,
		seats: [
			{ session: "skillgrowth", seat: "TurquoisePuma", goalPaused: true, goalPausedAt: AFTER_BOOT },
			{ session: "skillgrowth", seat: "FoggyValley", goalPaused: false, goalPausedAt: null },
		],
	});
	expect(first.status).toBe("SENT");
	expect(first.key).toBe(`restore-${BOOT_S}`);
	const rows = outbox(state);
	expect(rows.length).toBe(1);
	expect(rows[0]!.to).toBe(HANDLE);
	expect(rows[0]!.text).toContain("skillgrowth/TurquoisePuma");
	expect(rows[0]!.text).not.toContain("FoggyValley");
	expect(rows[0]!.text).toContain('Reply "resume all"');
}, fixtureDeadlineS(60) * 1000);

test("RESTORENOTICE1 a second tick in the same boot sends nothing", async () => {
	const { home, state, imsgBin } = makeHome("same-boot");
	const env = { ...process.env as Record<string, string>, IMSG_STUB_STATE: state };
	const seats = [{ session: "skillgrowth", seat: "TurquoisePuma", goalPaused: true, goalPausedAt: AFTER_BOOT }];
	const first = restoreNotice({ home, env, config: config(join(home, "fleet-watch.json")), imsgBin, bootTimeS: BOOT_S, seats });
	expect(first.status).toBe("SENT");
	expect(outbox(state).length).toBe(1);
	const second = restoreNotice({ home, env, config: config(join(home, "fleet-watch.json")), imsgBin, bootTimeS: BOOT_S, seats });
	expect(second.status).toBe("DEDUPED");
	expect(outbox(state).length).toBe(1);
}, fixtureDeadlineS(60) * 1000);

// The bridge ticks every 60 s; status is read only inside the post-boot window and only until
// this boot's notice is recorded, so a quiet host pays one small file read per tick.
test("RESTORENOTICE1 the status read is due only inside the post-boot window and before this boot's notice", async () => {
	const { home, state, imsgBin } = makeHome("due-window");
	const env = { ...process.env as Record<string, string>, IMSG_STUB_STATE: state };
	expect(restoreNoticeDue(home, BOOT_S, BOOT_S + 60)).toBe(true);
	expect(restoreNoticeDue(home, BOOT_S, BOOT_S + RESTORE_NOTICE_WINDOW_S + 1)).toBe(false);
	restoreNotice({ home, env, config: config(join(home, "fleet-watch.json")), imsgBin, bootTimeS: BOOT_S,
		seats: [{ session: "skillgrowth", seat: "TurquoisePuma", goalPaused: true, goalPausedAt: AFTER_BOOT }] });
	expect(restoreNoticeDue(home, BOOT_S, BOOT_S + 120)).toBe(false);
	expect(restoreNoticeDue(home, BOOT_S + 86_400, BOOT_S + 86_400 + 60)).toBe(true);
}, fixtureDeadlineS(60) * 1000);

test("RESTORENOTICE1 planted negative: no paused seat sends nothing", async () => {
	const { home, state, imsgBin } = makeHome("none-paused");
	const env = { ...process.env as Record<string, string>, IMSG_STUB_STATE: state };
	const result = restoreNotice({
		home, env, config: config(join(home, "fleet-watch.json")), imsgBin, bootTimeS: BOOT_S,
		seats: [{ session: "skillgrowth", seat: "FoggyValley", goalPaused: false, goalPausedAt: null }],
	});
	expect(result.status).toBe("SKIPPED");
	expect(outbox(state).length).toBe(0);
}, fixtureDeadlineS(60) * 1000);

// Joshua 2026-11-13: "i only want to be notified if its something that I need to act on". A seat he
// paused before the reboot is his decision, not news: no message, even though it reads paused now.
test("RESTORENOTICE1 planted negative: a seat paused before boot sends nothing", async () => {
	const { home, state, imsgBin } = makeHome("paused-before-boot");
	const env = { ...process.env as Record<string, string>, IMSG_STUB_STATE: state };
	const result = restoreNotice({
		home, env, config: config(join(home, "fleet-watch.json")), imsgBin, bootTimeS: BOOT_S,
		seats: [{ session: "skillgrowth", seat: "FoggyValley", goalPaused: true, goalPausedAt: BEFORE_BOOT }],
	});
	expect(result.status).toBe("SKIPPED");
	expect(outbox(state).length).toBe(0);
}, fixtureDeadlineS(60) * 1000);

test("RESTORENOTICE1 projectStatus reports goalPaused per seat", async () => {
	const home = join(scratch.path, "status-goal-paused");
	const stateRoot = join(home, ".local", "state", "omp-kit");
	mkdirSync(stateRoot, { recursive: true });
	chmodSync(stateRoot, 0o700);
	const sessionsDir = join(home, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const directorFile = join(sessionsDir, "director.jsonl");
	const workerFile = join(sessionsDir, "worker.jsonl");
	const goal = (id: string, objective: string) =>
		JSON.stringify({ type: "mode_change", id, parentId: "m1", mode: "goal", data: { goal: { id: `goal-${id}`, objective, status: "active" } } });
	writeFileSync(directorFile, `${goal("g1", "Grow the skill library")}\n${JSON.stringify({ type: "mode_change", id: "g2", parentId: "g1", timestamp: AFTER_BOOT, mode: "goal_paused" })}\n`);
	writeFileSync(workerFile, `${goal("g1", "Tend the queue")}\n`);
	const repo = join(home, "repo");
	mkdirSync(repo, { recursive: true });
	const fleetWatchDir = join(home, ".config", "omp-kit");
	mkdirSync(fleetWatchDir, { recursive: true });
	writeFileSync(join(fleetWatchDir, "fleet-watch.json"), `${JSON.stringify({ sessions: [{ session: "skillgrowth", repo, coordinatorPane: "tern:5", workerPanes: ["tern:6"] }] })}\n`);
	const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home };
	const exec = {
		run: async (argv: readonly string[]) => {
			if (argv[0] === "tern") {
				return { code: 0, out: JSON.stringify({ sessions: [{ name: "s", tabs: [{ name: "t", blocks: [5, 6] }] }], panes: [{ pane: "5", omp_session_file: directorFile, exited: null }, { pane: "6", omp_session_file: workerFile, exited: null }] }), err: "" };
			}
			if (argv[0] === "am") {
				const pane = String(argv[argv.indexOf("--pane") + 1] ?? "");
				const name = pane === "tern:5" ? "TurquoisePuma" : "FoggyValley";
				return { code: 0, out: JSON.stringify({ agent_name: name }), err: "" };
			}
			if (argv[0] === "br") return { code: 0, out: JSON.stringify({ issues: [], total: 0 }), err: "" };
			return { code: 1, out: "", err: "stub" };
		},
	};
	const reported = await projectStatus({ session: "skillgrowth", env, deps: { exec } });
	if (!reported.ok) throw new Error(reported.detail);
	expect(reported.status.seats.map((seat) => seat.goalPaused)).toEqual([true, false]);
	expect(reported.status.seats.map((seat) => seat.goalPausedAt)).toEqual([AFTER_BOOT, null]);
	expect(reported.status.seats[0]!.activeGoal).toBe(null);
	expect(reported.status.seats[1]!.activeGoal).toBe("Tend the queue");
}, fixtureDeadlineS(60) * 1000);
