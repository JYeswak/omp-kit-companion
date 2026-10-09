import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePairings } from "../../src/watch-actuator.ts";
import type { WatchPairing } from "../../src/watch-actuator.ts";

const FIXTURES = join(import.meta.dir, "../fixtures/watch-actuator");

function load(name: string): WatchPairing {
	const raw = readFileSync(join(FIXTURES, name), "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object") throw new Error(`bad fixture ${name}`);
	if (!("watch" in parsed) || !("actuator" in parsed) || !("lastActivityMs" in parsed) || !("actuations" in parsed)) {
		throw new Error(`bad fixture shape ${name}`);
	}
	const actuator = parsed.actuator;
	if (!actuator || typeof actuator !== "object") throw new Error(`bad actuator shape ${name}`);
	if (!("kind" in actuator) || !("maxIdleSeconds" in actuator)) throw new Error(`bad actuator shape ${name}`);
	const kind = actuator.kind;
	if (kind !== "nudge" && kind !== "page" && kind !== "file") throw new Error(`bad actuator kind ${name}`);
	if (!Array.isArray(parsed.actuations)) throw new Error(`bad actuations shape ${name}`);
	const actuations: WatchPairing["actuations"] = [];
	for (const entry of parsed.actuations) {
		if (!entry || typeof entry !== "object" || !("atMs" in entry) || !("kind" in entry) || !("detail" in entry)) {
			throw new Error(`bad actuation shape ${name}`);
		}
		if (entry.kind !== "nudge" && entry.kind !== "page" && entry.kind !== "file") throw new Error(`bad actuation kind ${name}`);
		actuations.push({ atMs: Number(entry.atMs), kind: entry.kind, detail: String(entry.detail) });
	}
	return { watch: String(parsed.watch), actuator: { kind, maxIdleSeconds: Number(actuator.maxIdleSeconds) }, lastActivityMs: Number(parsed.lastActivityMs), actuations };
}

test("idle fleet past SLA with no actuation is flagged", () => {
	const pairing = load("flagged.json");
	const rows = evaluatePairings([pairing], pairing.lastActivityMs + 600_000);
	expect(rows).toHaveLength(1);
	expect(rows[0].status).toBe("FLAGGED");
	expect(rows[0].idleSeconds).toBe(600);
	expect(rows[0].lastActuationMs).toBeNull();
});

test("actuation receipt within SLA is green", () => {
	const pairing = load("green.json");
	const rows = evaluatePairings([pairing], pairing.lastActivityMs + 600_000);
	expect(rows).toHaveLength(1);
	expect(rows[0].status).toBe("OK");
	expect(rows[0].idleSeconds).toBe(600);
	expect(rows[0].reason).toContain("within SLA");
});

test("fresh fleet within SLA is green without actuation", () => {
	const pairing = load("flagged.json");
	const rows = evaluatePairings([pairing], pairing.lastActivityMs + 60_000);
	expect(rows[0].status).toBe("OK");
	expect(rows[0].reason).toContain("within SLA");
});

test("stale actuation past SLA is flagged", () => {
	const pairing = load("green.json");
	const rows = evaluatePairings([pairing], pairing.lastActivityMs + 3_600_000);
	expect(rows[0].status).toBe("FLAGGED");
	expect(rows[0].lastActuationMs).toBe(1759746540000);
});
