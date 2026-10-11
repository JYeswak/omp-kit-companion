import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { proveSend, type SendExec } from "../../src/send.ts";

// Planted RED (G24a, Agent Mail 48369): a marker sitting UNSUBMITTED in omp's
// input box is not a delivery. Claude frame excerpts are OMP 18.8.6 --profile claude captures.
const repoRoot = resolve(import.meta.dir, "../..");
const fixtures = join(repoRoot, "tests", "fixtures", "send");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "send-consumed-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=send-consumed-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");

// Hermetic tmux selection: without this, proveSend reads the runner's env, and a CI
// runner outside tmux probes every candidate socket through the fake exec (all "live")
// and refuses TMUX_AMBIGUOUS before sending.
const testEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: join(scratch, "managed") };
delete testEnv.TMUX;

const noWait = async (_ms: number) => {};
const MARKER = /kit-send-[0-9a-f]{12}/;

/** Fake pane that renders a real fixture, with the fixture's marker swapped for the one proveSend generated. */
function fixturePane(name: string, afterEnter?: (marker: string) => string): { exec: SendExec; sentMarkers: string[]; argvLog: string[][] } {
	const screen = readFileSync(join(fixtures, name), "utf8");
	const sentMarkers: string[] = [];
	const argvLog: string[][] = [];
	let entered = false;
	return {
		sentMarkers,
		argvLog,
		exec: {
			run(argv: string[]) {
				argvLog.push(argv);
				if (argv[0] === "ntm") {
					const m = /\[(kit-send-[0-9a-f]{12})\]$/.exec(argv[argv.length - 1] ?? "");
					if (m) sentMarkers.push(m[1]!);
					return { code: 0, out: "sent" };
				}
				if (argv[1] === "send-keys") {
					entered = true;
					return { code: 0, out: "" };
				}
				const live = sentMarkers[sentMarkers.length - 1];
				if (live && entered && afterEnter) return { code: 0, out: afterEnter(live) };
				return { code: 0, out: live ? screen.replace(MARKER, live) : screen };
			},
		},
	};
}

/** Idle-empty fixture with the marker rendered ABOVE the input box, i.e. submitted. */
function submitted(marker: string): string {
	const lines = readFileSync(join(fixtures, "omp-idle-empty.txt"), "utf8").split("\n");
	const top = lines.findLastIndex((line) => line.trimStart().startsWith("╭──"));
	lines.splice(top, 0, ` fixture probe line one [${marker}]`);
	return lines.join("\n");
}

function dropDir(): string {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
}

const run = (exec: SendExec) =>
	proveSend({ session: "s", pane: "%1", message: "fixture probe line one", dropDir: dropDir(), exec, env: testEnv, pollMs: 1, deadlineMs: 20, wait: noWait });

test("RED-1: marker unsubmitted in the composer is PENDING_SUBMIT, not OK", async () => {
	const { exec, sentMarkers } = fixturePane("omp-idle-composer-pending.txt");
	const got = await run(exec);
	expect(sentMarkers.length).toBeGreaterThan(0);
	expect(got.status).not.toBe("OK");
	expect(got.status as string).toBe("PENDING_SUBMIT");
});

test("RED-2: marker unsubmitted in a multiline composer is PENDING_SUBMIT, not OK", async () => {
	const { exec, sentMarkers } = fixturePane("omp-idle-composer-pending-multiline.txt");
	const got = await run(exec);
	expect(sentMarkers.length).toBeGreaterThan(0);
	expect(got.status).not.toBe("OK");
	expect(got.status as string).toBe("PENDING_SUBMIT");
});

test("CONTROL: idle pane without the marker returns NOT_DELIVERED", async () => {
	const { exec } = fixturePane("omp-idle-empty.txt");
	const got = await run(exec);
	expect(got.status).toBe("NOT_DELIVERED");
});

test("GREEN: one Enter submits the composer text; marker above the box is OK", async () => {
	const { exec, argvLog } = fixturePane("omp-idle-composer-pending.txt", submitted);
	const got = await run(exec);
	expect(got.status).toBe("OK");
	expect(got.drop_path).toBeNull();
	const enters = argvLog.filter((argv) => argv[1] === "send-keys");
	expect(enters).toEqual([["tmux", "send-keys", "-t", "%1", "Enter"]]);
	expect(argvLog.filter((argv) => argv[0] === "ntm").length).toBe(1);
});

test("CLAUDE: submitted marker above the current `❯` composer is OK without Enter", async () => {
	const { exec, argvLog } = fixturePane("omp-claude-submitted-answered.txt");
	const got = await run(exec);
	expect(got.status).toBe("OK");
	expect(argvLog.filter((argv) => argv[1] === "send-keys")).toEqual([]);
});

test("CLAUDE: marker left in the `❯` composer remains PENDING_SUBMIT", async () => {
	const { exec, argvLog } = fixturePane("omp-claude-composer-pending.txt");
	const got = await run(exec);
	expect(got.status as string).toBe("PENDING_SUBMIT");
	expect(got.status).not.toBe("OK");
	expect(argvLog.filter((argv) => argv[1] === "send-keys")).toEqual([["tmux", "send-keys", "-t", "%1", "Enter"]]);
});

test("CLAUDE: one Enter moves the composer marker into submitted history", async () => {
	const { exec, argvLog } = fixturePane("omp-claude-composer-pending.txt", (marker) =>
		readFileSync(join(fixtures, "omp-claude-submitted-answered.txt"), "utf8").replace(MARKER, marker),
	);
	const got = await run(exec);
	expect(got.status).toBe("OK");
	expect(argvLog.filter((argv) => argv[1] === "send-keys")).toEqual([["tmux", "send-keys", "-t", "%1", "Enter"]]);
});

/** Fake pane serving one capture screen per capture-pane call (last repeats); send-keys recorded, never acted on. */
function sequencePane(screens: ((marker: string) => string)[]): { exec: SendExec; argvLog: string[][]; ntmCount: () => number } {
	const argvLog: string[][] = [];
	let ntm = 0;
	let marker = "";
	let captures = 0;
	return {
		argvLog,
		ntmCount: () => ntm,
		exec: {
			run(argv: string[]) {
				argvLog.push(argv);
				if (argv[0] === "ntm") {
					ntm++;
					const m = /\[(kit-send-[0-9a-f]{12})\]$/.exec(argv[argv.length - 1] ?? "");
					if (m) marker = m[1]!;
					return { code: 0, out: "sent" };
				}
				if (argv[1] === "send-keys") return { code: 0, out: "" };
				const screen = screens[Math.min(captures++, screens.length - 1)]!;
				return { code: 0, out: marker ? screen(marker) : "" };
			},
		},
	};
}

/** ompkit-rq59 screen pair: busy composer (receiver working) then self-cleared. Reads both fixtures once so the pair stays in lockstep. */
function rq59Screens(): { busy: (marker: string) => string; cleared: (marker: string) => string } {
	const pending = readFileSync(join(fixtures, "omp-claude-composer-pending.txt"), "utf8");
	const answered = readFileSync(join(fixtures, "omp-claude-submitted-answered.txt"), "utf8");
	return {
		busy: (marker: string) => pending.replace(MARKER, marker) + "\n⠋ Working…",
		cleared: (marker: string) => answered.replace(MARKER, marker),
	};
}

// ompkit-rq59: the receiver picked the text up fast (composer cleared, turn
// running) while the marker poll was still watching. That is a submitted
// delivery, not PENDING_SUBMIT -- and it must cost zero Enters.
test("FAST_PICKUP: busy pane clears the composer itself; OK without Enter, one ntm send", async () => {
	const screens = rq59Screens();
	const pane = sequencePane([screens.busy, screens.cleared]);
	const got = await run(pane.exec);
	expect(got.status).toBe("OK");
	expect(got.drop_path).toBeNull();
	expect(got.detail).toContain("receiver active");
	expect(pane.argvLog.filter((argv) => argv[1] === "send-keys")).toEqual([]);
	expect(pane.ntmCount()).toBe(1);
});

// Planted negative: the pane stays busy with the marker in its composer, so
// the send is unproven. Enter is withheld (no double submit into a live
// turn); the same marker key goes to the drop file, and there is no second
// blind send of text the agent may already hold.
test("BUSY_STUCK: marker held in a busy composer; NOT_DELIVERED with drop, no Enter, no resend", async () => {
	const stuck = rq59Screens();
	const pane = sequencePane([stuck.busy]);
	const dir = dropDir();
	const got = await proveSend({ session: "s", pane: "%1", message: "fixture probe line one", dropDir: dir, exec: pane.exec, env: testEnv, pollMs: 1, deadlineMs: 20, wait: noWait });
	expect(got.status).toBe("NOT_DELIVERED");
	expect(got.drop_path).not.toBeNull();
	expect(readdirSync(dir).length).toBe(1);
	expect(existsSync(got.drop_path!)).toBe(true);
	expect(pane.argvLog.filter((argv) => argv[1] === "send-keys")).toEqual([]);
	expect(pane.ntmCount()).toBe(1);
});

// A `Steering · N` queue line on an otherwise idle pane changes nothing: no
// spinner means the idle path still applies (one bounded Enter), and the
// queue text must not corrupt the composer classification.
test("STEERING_IDLE: queue line without a spinner keeps the idle path; still PENDING_SUBMIT after one Enter", async () => {
	const queued = (marker: string) =>
		readFileSync(join(fixtures, "omp-idle-composer-pending.txt"), "utf8").replace(MARKER, marker) + "\nSteering · 2";
	const pane = sequencePane([queued]);
	const got = await run(pane.exec);
	expect(got.status as string).toBe("PENDING_SUBMIT");
	expect(pane.argvLog.filter((argv) => argv[1] === "send-keys")).toEqual([["tmux", "send-keys", "-t", "%1", "Enter"]]);
});