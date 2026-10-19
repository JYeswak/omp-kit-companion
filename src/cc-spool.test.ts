/** Unit tests for the byte-compatible spool writer (bead ompkit-fp72.120.16.11.3). */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, ccSpool, isoMs, makeId } from "./cc-spool.ts";

const FIXTURES = "tests/fixtures/cc-spool-golden.jsonl";

function goldens(): Array<{
	producer: string;
	key: string;
	type: string;
	time_ms: number;
	observed_ms: number;
	data: Record<string, unknown>;
	line: string;
}> {
	return readFileSync(FIXTURES, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
}

function ownedState(clock: () => number = Date.now): string {
	const st = mkdtempSync(join(tmpdir(), "ccspool-"));
	mkdirSync(join(st, "spool"), { recursive: true });
	return st;
}

describe("cc-spool", () => {
	test("make_id matches cclib (sha256 producer\\x1fposition\\xtype, 32 hex)", () => {
		expect(makeId("kit", "verb:doctor:0001", "action.attempt")).toBe("d430a3ff88c69377a83d4e959e9aa35c");
	});

	test("parity_golden: TS bytes equal cclib canonical bytes for all fixtures", () => {
		const st = ownedState();
		for (const g of goldens()) {
			const a = ccSpool(g.producer, { stateDir: st, clock: () => g.observed_ms })!;
			const env = a.envelope(g.type, g.data, { key: g.key, timeMs: g.time_ms, observedMs: g.observed_ms });
			expect(canonical(env)).toBe(g.line);
		}
	});

	test("parity_golden: ingester-visible id/position/dataschema fields match", () => {
		const st = ownedState();
		for (const g of goldens()) {
			const a = ccSpool(g.producer, { stateDir: st, clock: () => g.observed_ms })!;
			const env = a.envelope(g.type, g.data, { key: g.key, timeMs: g.time_ms, observedMs: g.observed_ms });
			const want = JSON.parse(g.line);
			for (const k of ["id", "position", "dataschema", "producer", "type", "source", "time", "observed"]) {
				expect(env[k]).toBe(want[k]);
			}
		}
	});

	test("inert_without_state: no state dir returns null and creates nothing", () => {
		const home = mkdtempSync(join(tmpdir(), "ccspool-home-"));
		const before = readdirSync(home).sort();
		const prevHome = process.env.HOME;
		const prevCc = process.env.CC_STATE;
		process.env.HOME = home;
		delete process.env.CC_STATE;
		try {
			expect(ccSpool("kit")).toBeNull();
			expect(readdirSync(home).sort()).toEqual(before);
		} finally {
			if (prevHome !== undefined) process.env.HOME = prevHome;
			if (prevCc !== undefined) process.env.CC_STATE = prevCc;
		}
	});

	test("inert_without_state: state dir without spool/ returns null", () => {
		const st = mkdtempSync(join(tmpdir(), "ccspool-nofleet-"));
		expect(ccSpool("kit", { stateDir: st })).toBeNull();
		expect(readdirSync(st)).toEqual([]);
	});

	test("inert_without_state: OMP_KIT_CC=0 returns null even with state", () => {
		const st = ownedState();
		process.env.OMP_KIT_CC = "0";
		try {
			expect(ccSpool("kit", { stateDir: st })).toBeNull();
		} finally {
			delete process.env.OMP_KIT_CC;
		}
	});

	test("redaction_replaces_line: planted ghp_ token becomes cc.unknown, token never on disk", () => {
		const token = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36)}`;
		const st = ownedState(() => 1_769_000_005_000);
		const a = ccSpool("kit", { stateDir: st, clock: () => 1_769_000_005_000 })!;
		const env = a.envelope(
			"action.attempt",
			{ action_id: "doctor", surface: "cli", target: `token ${token}`, idempotency_key: null },
			{ key: "verb:evil:0001", timeMs: 1_769_000_005_000 },
		);
		expect(a.append([env])).toBe(1);
		expect(a.failures).toBe(0);
		const day = isoMs(1_769_000_005_000).slice(0, 10);
		const body = readFileSync(join(st, "spool", "kit", `${day}.jsonl`), "utf8");
		expect(body.includes(token)).toBe(false);
		const lines = body.trim().split("\n");
		expect(lines).toHaveLength(1);
		const red = JSON.parse(lines[0]!);
		expect(red.type).toBe("cc.unknown");
		expect(red.data.class).toBe("U-redaction");
		expect(red.data.detail).toBe("CREDENTIAL_SHAPE_AT_PRODUCER");
		expect(red.dataschema).toBe("cc.unknown@1");
		expect(red.id).toBe(makeId("kit", `redaction:${env.id}`, "cc.unknown"));
	});

	test("redaction_replaces_line: planted AKIA-shaped string is refused with a U-redaction line", () => {
		const key = `AKIA${"IOSFODNN7EXAMPLE0000".slice(0, 16)}`;
		const st = ownedState(() => 1_769_000_006_000);
		const a = ccSpool("hooks", { stateDir: st, clock: () => 1_769_000_006_000 })!;
		const env = a.envelope(
			"action.result",
			{ action_id: "x", outcome: "ok", code: key, duration_ms: 3 },
			{ key: "hook:evil:0002", timeMs: 1_769_000_006_000 },
		);
		expect(a.append([env])).toBe(1);
		const day = isoMs(1_769_000_006_000).slice(0, 10);
		const body = readFileSync(join(st, "spool", "hooks", `${day}.jsonl`), "utf8");
		expect(body.includes(key)).toBe(false);
		expect(JSON.parse(body.trim()).data.class).toBe("U-redaction");
	});

	test("tail_fragment_terminated: unterminated tail stands alone, next append starts on a new line", () => {
		const now = 1_769_000_007_000;
		const st = ownedState(() => now);
		const a = ccSpool("kit", { stateDir: st, clock: () => now })!;
		const day = isoMs(now).slice(0, 10);
		mkdirSync(join(st, "spool", "kit"), { recursive: true });
		writeFileSync(join(st, "spool", "kit", `${day}.jsonl`), '{"fragment": tru');
		const env = a.envelope(
			"action.attempt",
			{ action_id: "d", surface: "cli", target: null, idempotency_key: null },
			{ key: "verb:tail:0001", timeMs: now },
		);
		expect(a.append([env])).toBe(1);
		const lines = readFileSync(join(st, "spool", "kit", `${day}.jsonl`), "utf8").split("\n");
		expect(lines[0]).toBe('{"fragment": tru');
		expect(JSON.parse(lines[1]!).id).toBe(env.id);
	});

	test("newest_day_not_regressed: clock planted to an earlier day still appends to the newest file", () => {
		const late = Date.parse("2026-10-25T00:00:00.000Z");
		const early = Date.parse("2026-10-19T00:00:00.000Z");
		const st = ownedState(() => late);
		const aLate = ccSpool("kit", { stateDir: st, clock: () => late })!;
		const envLate = aLate.envelope(
			"action.attempt",
			{ action_id: "d", surface: "cli", target: null, idempotency_key: null },
			{ key: "verb:late:0001", timeMs: late },
		);
		expect(aLate.append([envLate])).toBe(1);
		const aEarly = ccSpool("kit", { stateDir: st, clock: () => early })!;
		const envEarly = aEarly.envelope(
			"action.attempt",
			{ action_id: "d", surface: "cli", target: null, idempotency_key: null },
			{ key: "verb:early:0001", timeMs: early },
		);
		expect(aEarly.append([envEarly])).toBe(1);
		const files = readdirSync(join(st, "spool", "kit")).sort();
		expect(files).toEqual(["2026-10-25.jsonl"]);
		const ids = readFileSync(join(st, "spool", "kit", "2026-10-25.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).id);
		expect(ids).toEqual([envLate.id, envEarly.id]);
	});

	test("readonly_dir_never_throws: verb exit unchanged, adapter.failures==1", () => {
		const now = 1_769_000_008_000;
		const st = ownedState(() => now);
		const a = ccSpool("kit", { stateDir: st, clock: () => now })!;
		mkdirSync(join(st, "spool", "kit"), { recursive: true });
		chmodSync(join(st, "spool", "kit"), 0o555);
		chmodSync(join(st, "spool"), 0o555);
		try {
			const env = a.envelope(
				"action.attempt",
				{ action_id: "d", surface: "cli", target: null, idempotency_key: null },
				{ key: "verb:ro:0001", timeMs: now },
			);
			expect(a.append([env])).toBe(0);
			expect(a.failures).toBe(1);
		} finally {
			chmodSync(join(st, "spool"), 0o755);
			chmodSync(join(st, "spool", "kit"), 0o755);
		}
	});

	test("nan_refused: non-finite data never throws and writes nothing", () => {
		const now = 1_769_000_009_000;
		const st = ownedState(() => now);
		const a = ccSpool("kit", { stateDir: st, clock: () => now })!;
		const env = a.envelope(
			"action.attempt",
			{ action_id: "d", surface: "cli", target: null, idempotency_key: null },
			{ key: "verb:nan:0001", timeMs: now },
		);
		(env.data as Record<string, unknown>).duration_ms = Number.NaN;
		expect(a.append([env])).toBe(0);
		expect(a.failures).toBe(1);
		expect(existsSync(join(st, "spool", "kit")) ? readdirSync(join(st, "spool", "kit")).filter((f) => f.endsWith(".jsonl")) : []).toEqual([]);
	});

	test("undeclared producer refused", () => {
		expect(() => ccSpool("nope", { stateDir: ownedState() })).toThrow("PRODUCER_UNDECLARED_OR_UNSAFE");
		expect(() => ccSpool("kit/x", { stateDir: ownedState() })).toThrow("PRODUCER_UNDECLARED_OR_UNSAFE");
	});

	test("undeclared type refused at envelope time", () => {
		const st = ownedState();
		const a = ccSpool("kit", { stateDir: st })!;
		expect(() =>
			a.envelope("bogus.type", { a: 1 }, { key: "k", timeMs: 1_769_000_000_000 }),
		).toThrow("TYPE_UNDECLARED");
	});

	test("canonical: nested sort, separators, raw non-ASCII", () => {
		expect(canonical({ b: 1, a: { z: [3, 2], y: "café" } })).toBe('{"a":{"y":"café","z":[3,2]},"b":1}');
		expect(() => canonical({ x: Number.POSITIVE_INFINITY })).toThrow();
	});
});
