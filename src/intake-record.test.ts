// intake-record.test.ts — INTAKE1 record slice (ompkit-fp72.19.1.19): the
// record path appends one exact JSONL row per request, never dedupes, and
// refuses malformed repo paths before any write.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp, type OwnedTmp } from "./kitlib/tmp.ts";
import {
	beadArgsFor,
	formatRouteLine,
	handleIntake,
	recordIntakeRow,
	resolveDecisionsPath,
	type BrRunner,
} from "./intake-record.ts";

const owned: OwnedTmp[] = [];
afterAll(() => {
	for (const t of owned) t.cleanup();
});

function fixtureRepo(): string {
	const t = ownedTmp("intakerecord-repo");
	owned.push(t);
	return t.path;
}

function readRows(repo: string): string[] {
	return readFileSync(join(repo, "decisions", "joshua.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}

const noMatchBr: BrRunner = () => ({ argv: [], code: 0, out: JSON.stringify({ issues: [] }) });

test("rule intake appends the exact row and prints DO + reply", () => {
	const repo = fixtureRepo();
	try {
		const result = handleIntake({
			repo,
			text: "always confirm before landing",
			kind: "rule",
			seat: "joshua",
			role: "owner",
			now: () => "2026-10-19T00:00:00.000Z",
		});
		const rows = readRows(repo);
		expect(rows.length).toBe(1);
		expect(JSON.parse(rows[0])).toEqual({
			at: "2026-10-19T00:00:00.000Z",
			from: "joshua",
			text: "always confirm before landing",
			kind: "rule",
			route: "DO",
			bead: null,
			seat: "joshua",
			role: "owner",
		});
		const lines = result.stdout.split("\n");
		expect(lines[0]).toBe("DO");
		expect(lines[1].length).toBeGreaterThan(0);
		expect(result.json).toEqual({ route: "DO", bead: null, reply: lines[1] });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("duplicate identical requests record twice with distinct at (no dedupe loss)", () => {
	const repo = fixtureRepo();
	try {
		let tick = 0;
		const now = () => `2026-10-19T00:00:0${tick++}.000Z`;
		for (let n = 0; n < 2; n++) {
			recordIntakeRow({
				repo,
				text: "same request twice",
				kind: "work",
				route: "PENDING",
				bead: null,
				seat: "joshua",
				role: "owner",
				now,
			});
		}
		const rows = readRows(repo).map((line) => JSON.parse(line));
		expect(rows.length).toBe(2);
		expect(rows[0].at).not.toBe(rows[1].at);
		expect(rows[0].text).toBe(rows[1].text);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("work intake with no open match records bead:null route PENDING and prints bead args JSON", () => {
	const repo = fixtureRepo();
	try {
		const result = handleIntake({
			repo,
			text: "build the flux capacitor",
			kind: "work",
			seat: "bench",
			role: "builder",
			runBr: noMatchBr,
		});
		expect(result.row.bead).toBeNull();
		expect(result.row.route).toBe("PENDING");
		const lines = result.stdout.split("\n");
		expect(lines[0]).toBe("PENDING");
		expect(lines[1].length).toBeGreaterThan(0);
		const printed = JSON.parse(lines[2]);
		expect(printed).toEqual(beadArgsFor("build the flux capacitor"));
		expect(printed.title.length).toBeGreaterThan(0);
		expect(printed.acceptance.length).toBeGreaterThan(0);
		expect(printed.parentPrompt).toContain("build the flux capacitor");
		expect(result.json.beadArgs).toEqual(printed);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("work intake matching an open bead records ROUTE with the bead id", () => {
	const repo = fixtureRepo();
	const matchBr: BrRunner = () => ({
		argv: [],
		code: 0,
		out: JSON.stringify({ issues: [{ id: "ompkit-xa5s" }] }),
	});
	try {
		const result = handleIntake({
			repo,
			text: "flux capacitor",
			kind: "work",
			seat: "bench",
			role: "builder",
			runBr: matchBr,
		});
		expect(result.row.bead).toBe("ompkit-xa5s");
		expect(result.row.route).toBe("ROUTE ompkit-xa5s -> bench");
		expect(result.stdout.split("\n")[0]).toBe("ROUTE ompkit-xa5s -> bench");
		expect(formatRouteLine(result.row.route, result.row.bead, "bench")).toBe("ROUTE ompkit-xa5s -> bench");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("malformed repo paths throw and never write", () => {
	for (const bad of ["", "   ", "relative/path", "/definitely/not/a/real/repo-9z9z9z"]) {
		expect(() => resolveDecisionsPath(bad)).toThrow();
		expect(() =>
			recordIntakeRow({
				repo: bad,
				text: "x",
				kind: "rule",
				route: "DO",
				bead: null,
				seat: "joshua",
				role: "owner",
			}),
		).toThrow();
	}
	// A path that exists but is a file, not a directory, also refuses.
	const fileDir = ownedTmp("intakerecord-file");
	owned.push(fileDir);
	const file = join(fileDir.path, "notadir");
	writeFileSync(file, "x\n");
	try {
		expect(() => resolveDecisionsPath(file)).toThrow();
		expect(existsSync(file + "-should-never-exist")).toBe(false);
	} finally {
		rmSync(join(file, ".."), { recursive: true, force: true });
	}
	// The never-exists target was never created by the refused writes.
	expect(existsSync("/definitely/not/a/real/repo-9z9z9z")).toBe(false);
});
