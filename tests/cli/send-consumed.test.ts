import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
	proveSend({ session: "s", pane: "%1", message: "fixture probe line one", dropDir: dropDir(), exec, pollMs: 1, deadlineMs: 20, wait: noWait });

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

test.todo("CONSUMED: consumption reader confirms the marker in a role:user row of the target's omp session JSONL");
test.todo("QUEUED_STUCK: marker in a `Steering · N` queue on an idle pane");
test.todo("QUEUED: marker queued while the target pane is busy");
