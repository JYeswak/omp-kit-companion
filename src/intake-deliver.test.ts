// intake-deliver.test.ts — INTAKE1 deliver slice (ompkit-fp72.19.1.19):
// ROUTE delivery (br assignee + agent mail + tern) with a session-file
// marker proof (one retry, then the drop-folder fallback), deterministic
// markers for idempotent redelivery, and hourly fleet_report counts from
// the record slice's ledger. All externals are fakes; no subprocess runs.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp, type OwnedTmp } from "./kitlib/tmp.ts";
import {
	INTAKE_DELIVER_HOUR_MS,
	deliverRoute,
	intakeCountsLine,
	markerFor,
	readIntakeRows,
	summarizeIntakeHour,
	type IntakeCountRow,
} from "./intake-deliver.ts";

const BEAD = "ompkit-fp72-19";
const SEAT = "w1";
const TEXT = "fix this flaky test";
const PROJECT = "omp-kit";
const SESSION = "fleet";
const PANE = "1";
const WINDOW = "fleet-window";
const HOUR = Date.parse("2026-10-19T05:00:00.000Z");

const owned: OwnedTmp[] = [];
afterAll(() => {
	for (const t of owned) t.cleanup();
});

function fixtureRepo(): string {
	const t = ownedTmp("intakedeliver-repo");
	owned.push(t);
	return t.path;
}

function baseInput(repo: string, dropDir: string, sessionFile: string) {
	return {
		repo,
		bead: BEAD,
		seat: SEAT,
		text: TEXT,
		project: PROJECT,
		session: SESSION,
		pane: PANE,
		windowKey: WINDOW,
		sessionFile,
		dropDir,
	};
}

test("ROUTE delivery runs br + mail + tern and proves the marker", async () => {
	const repo = fixtureRepo();
	const dropDir = join(repo, "send-drop");
	const sessionFile = join(repo, "session-journal.jsonl");
	const journal: { text: string | null } = { text: null };
	const marker = markerFor(BEAD, SEAT, TEXT);
	const brCalls: string[][] = [];
	const mailCalls: string[][] = [];
	let ternCalls = 0;
	try {
		const result = await deliverRoute(baseInput(repo, dropDir, sessionFile), {
			runBr: (argv, opts) => {
				brCalls.push(argv);
				expect(opts.cwd).toBe(repo);
				return { argv, code: 0, out: "{}" };
			},
			runMail: (argv) => {
				mailCalls.push(argv);
				return { code: 0, out: "{}" };
			},
			deliver: async () => {
				ternCalls++;
				journal.text = `USER entry proves it [${marker}]`;
				return { status: "OK", marker, sends: 1, sessionFile, offset: 42, drop_path: null,
					detail: "USER entry proven at offset 42", code: "PROVEN" };
			},
			readSessionFile: (path) => (path === sessionFile ? journal.text : null),
			wait: async () => {},
			now: () => HOUR + 1_000,
		});
		expect(result.status).toBe("DELIVERED");
		expect(result.marker).toBe(marker);
		expect(result.sends).toBe(1);
		expect(result.dropPath).toBeNull();
		expect(brCalls).toEqual([["br", "update", BEAD, "--assignee", SEAT, "--json"]]);
		expect(mailCalls.length).toBe(1);
		expect(mailCalls[0]!.slice(0, 3)).toEqual(["am", "mail", "send"]);
		expect(mailCalls[0]).toContain("--to");
		expect(mailCalls[0]![mailCalls[0]!.indexOf("--to") + 1]).toBe(SEAT);
		expect(ternCalls).toBe(1);
		expect(result.countsLine).toBe(intakeCountsLine(result.counts));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("NEG: session file without the marker fails proof and takes the fallback, counted", async () => {
	const repo = fixtureRepo();
	const dropDir = join(repo, "send-drop");
	const sessionFile = join(repo, "session-journal.jsonl");
	const marker = markerFor(BEAD, SEAT, TEXT);
	let reads = 0;
	try {
		const result = await deliverRoute(baseInput(repo, dropDir, sessionFile), {
			runBr: (argv) => ({ argv, code: 0, out: "{}" }),
			runMail: () => ({ code: 0, out: "{}" }),
			deliver: async () => ({ status: "OK", marker, sends: 1, sessionFile, offset: null, drop_path: null,
				detail: "tern claims effect, journal disagrees", code: "PROVEN" }),
			readSessionFile: (path) => {
				reads++;
				return path === sessionFile ? "USER entry with no marker here" : null;
			},
			wait: async () => {},
			now: () => HOUR + 2_000,
		});
		expect(result.status).toBe("FALLBACK");
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(result.dropPath).not.toBeNull();
		expect(existsSync(result.dropPath!)).toBe(true);
		expect(readdirSync(dropDir).length).toBe(1);
		const drop = readFileSync(result.dropPath!, "utf8");
		expect(drop).toContain(result.marker);
		expect(drop).toContain(TEXT);
		expect(result.counts.hour).toBe(new Date(HOUR).toISOString());
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("NEG: second identical delivery is idempotent, counted once", async () => {
	const repo = fixtureRepo();
	const dropDir = join(repo, "send-drop");
	const sessionFile = join(repo, "session-journal.jsonl");
	const journal: { text: string | null } = { text: null };
	const marker = markerFor(BEAD, SEAT, TEXT);
	let brCalls = 0;
	let mailCalls = 0;
	let ternCalls = 0;
	const deps = {
		runBr: (argv: string[]) => {
			brCalls++;
			return { argv, code: 0, out: "{}" };
		},
		runMail: () => {
			mailCalls++;
			return { code: 0, out: "{}" };
		},
		deliver: async () => {
			ternCalls++;
			journal.text = `USER entry proves it [${marker}]`;
			return { status: "OK" as const, marker, sends: 1, sessionFile, offset: 7, drop_path: null,
				detail: "USER entry proven at offset 7", code: "PROVEN" };
		},
		readSessionFile: (path: string) => (path === sessionFile ? journal.text : null),
		wait: async (_ms: number) => {},
		now: () => HOUR + 3_000,
	};
	try {
		const first = await deliverRoute(baseInput(repo, dropDir, sessionFile), deps);
		expect(first.status).toBe("DELIVERED");
		const second = await deliverRoute(baseInput(repo, dropDir, sessionFile), deps);
		expect(second.status).toBe("ALREADY_DELIVERED");
		expect(second.sends).toBe(0);
		expect(second.dropPath).toBeNull();
		expect(brCalls).toBe(1);
		expect(mailCalls).toBe(1);
		expect(ternCalls).toBe(1);
		const rows: IntakeCountRow[] = [
			{ at: new Date(HOUR + 3_000).toISOString(), kind: "work", route: `ROUTE ${BEAD} -> ${SEAT}`, text: TEXT, role: "worker" },
		];
		const counts = summarizeIntakeHour(rows, HOUR);
		expect(counts.received).toBe(1);
		expect(counts.routed).toBe(1);
		expect(second.counts.received).toBe(0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("br failure aborts before mail and tern", async () => {
	const repo = fixtureRepo();
	const dropDir = join(repo, "send-drop");
	let mailCalls = 0;
	let ternCalls = 0;
	try {
		const result = await deliverRoute(baseInput(repo, dropDir, join(repo, "journal")), {
			runBr: (argv) => ({ argv, code: 1, out: "tracker unavailable" }),
			runMail: () => {
				mailCalls++;
				return { code: 0, out: "{}" };
			},
			deliver: async () => {
				ternCalls++;
				throw new Error("must not run");
			},
			readSessionFile: () => null,
			wait: async () => {},
			now: () => HOUR,
		});
		expect(result.status).toBe("BR_FAILED");
		expect(mailCalls).toBe(0);
		expect(ternCalls).toBe(0);
		expect(result.dropPath).toBeNull();
		expect(existsSync(dropDir)).toBe(false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("hourly counts split received, routed, done-in-role and overridden", () => {
	const rows: IntakeCountRow[] = [
		{ at: new Date(HOUR + 10).toISOString(), kind: "rule", route: "DO", text: "always confirm before landing", role: "owner" },
		{ at: new Date(HOUR + 20).toISOString(), kind: "work", route: `ROUTE ${BEAD} -> director`, text: "fix this flaky test", role: "director" },
		{ at: new Date(HOUR + 30).toISOString(), kind: "work", route: `DO ${BEAD}`, text: "fix this flaky test", role: "worker" },
		{ at: new Date(HOUR + 40).toISOString(), kind: "work", route: `DO ${BEAD}`, text: "triage the queue", role: "worker" },
		{ at: new Date(HOUR + INTAKE_DELIVER_HOUR_MS + 1).toISOString(), kind: "work", route: `DO ${BEAD}`, text: "fix next hour", role: "worker" },
		{ at: "not-a-timestamp", kind: "work", route: `DO ${BEAD}`, text: "fix broken row", role: "worker" },
	];
	const counts = summarizeIntakeHour(rows, HOUR);
	expect(counts.received).toBe(4);
	expect(counts.routed).toBe(1);
	expect(counts.doneInRole).toBe(1);
	expect(counts.overridden).toBe(1);
	expect(intakeCountsLine(counts)).toBe(
		`intake: hour=${new Date(HOUR).toISOString()} received=4 routed=1 done_in_role=1 overridden=1`,
	);
});

test("readIntakeRows reads the record ledger and skips malformed lines", () => {
	const repo = fixtureRepo();
	try {
		mkdirSync(join(repo, "decisions"), { recursive: true });
		writeFileSync(
			join(repo, "decisions", "joshua.jsonl"),
			[
				JSON.stringify({ at: new Date(HOUR).toISOString(), from: "joshua", text: TEXT, kind: "work", route: "DO", bead: BEAD, seat: SEAT, role: "worker" }),
				"broken line",
				JSON.stringify({ at: "bad", kind: "work", route: "DO", text: "x" }),
				"",
			].join("\n"),
			"utf8",
		);
		const rows = readIntakeRows(repo);
		expect(rows.length).toBe(1);
		expect(rows[0]!.role).toBe("worker");
		expect(readIntakeRows(join(repo, "missing-root-absent")).length).toBe(0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
