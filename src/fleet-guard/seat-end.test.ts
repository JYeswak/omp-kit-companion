import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp, type OwnedTmp } from "../kitlib/tmp.ts";
import type { ScratchReleaseResult } from "../scratch.ts";
import { endSeat, respawnIntentActive, respawnIntentPath, type SeatEndDeps } from "./seat-end.ts";

const agentTmp = join(import.meta.dir, "../../var/agent-tmp");
mkdirSync(agentTmp, { recursive: true });
const owned: OwnedTmp[] = [];
afterEach(() => {
	for (const t of owned.splice(0)) t.cleanup();
});

const START = "Mon Oct 19 01:00:00 2026";
const AT = "2026-10-19T01:30:00Z";
const AT_MS = Date.UTC(2026, 9, 19, 1, 30, 0);
const PID = 4242;
const RECORDED = { dir: "/seat/omp.4242", agent: "TurquoiseSummit", session: "S1" };

function stateRoot(): string {
	const t = ownedTmp("seat-end", { root: agentTmp });
	owned.push(t);
	return t.path;
}

function plant(root: string, row: Record<string, unknown>): string {
	const path = respawnIntentPath(PID, { XDG_STATE_HOME: root });
	mkdirSync(join(root, "omp-kit-orchestration"), { recursive: true });
	writeFileSync(path, JSON.stringify({ pid: PID, start: START, agent: "TurquoiseSummit", session: "S1", block: "b", at: AT, ttl_s: 900, kind: "respawn", ...row }));
	return path;
}

test("the intent path follows XDG_STATE_HOME, else ~/.local/state, keyed by the old pid", () => {
	expect(respawnIntentPath(7, { XDG_STATE_HOME: "/x" }, "/h")).toBe("/x/omp-kit-orchestration/respawn-intent.7.json");
	expect(respawnIntentPath(7, {}, "/h")).toBe("/h/.local/state/omp-kit-orchestration/respawn-intent.7.json");
	expect(respawnIntentPath(7, { XDG_STATE_HOME: "" }, "/h")).toBe("/h/.local/state/omp-kit-orchestration/respawn-intent.7.json");
});

test("SCRATCHBIN1: a matching, unexpired marker is active; every other shape is not", () => {
	const root = stateRoot();
	const now = AT_MS + 60_000;
	expect(respawnIntentActive(PID, START, plant(root, {}), now)).toBe(true);
	// planted negatives: pid reuse (other start), expired, future-dated, wrong pid, wrong kind, no start known
	expect(respawnIntentActive(PID, "Tue Oct 20 09:00:00 2026", plant(root, {}), now)).toBe(false);
	expect(respawnIntentActive(PID, START, plant(root, {}), AT_MS + 900_000)).toBe(false);
	expect(respawnIntentActive(PID, START, plant(root, {}), AT_MS + 899_999)).toBe(true);
	expect(respawnIntentActive(PID, null, plant(root, {}), now)).toBe(false);
	expect(respawnIntentActive(PID, null, plant(root, { start: null }), now)).toBe(false);
	expect(respawnIntentActive(PID, START, plant(root, {}), AT_MS - 1)).toBe(false);
	expect(respawnIntentActive(PID, START, plant(root, { pid: 4243 }), now)).toBe(false);
	expect(respawnIntentActive(PID, START, plant(root, { kind: "exit" }), now)).toBe(false);
	expect(respawnIntentActive(PID, null, plant(root, {}), now)).toBe(false);
	expect(respawnIntentActive(PID, START, plant(root, { ttl_s: "900" }), now)).toBe(false);
	expect(respawnIntentActive(PID, START, plant(root, { at: "yesterday" }), now)).toBe(false);
});

test("a missing or unparsable marker is not active", () => {
	const root = stateRoot();
	const path = respawnIntentPath(PID, { XDG_STATE_HOME: root });
	expect(respawnIntentActive(PID, START, path, AT_MS)).toBe(false);
	mkdirSync(join(root, "omp-kit-orchestration"), { recursive: true });
	writeFileSync(path, "{not json");
	expect(respawnIntentActive(PID, START, path, AT_MS)).toBe(false);
	writeFileSync(path, "null");
	expect(respawnIntentActive(PID, START, path, AT_MS)).toBe(false);
	expect(existsSync(path)).toBe(true);
});

function deps(root: string, released: string[], extra: Partial<SeatEndDeps> = {}): SeatEndDeps {
	return { startOf: () => START, env: { XDG_STATE_HOME: root }, now: AT_MS + 60_000,
		release: (dir, agent, session): ScratchReleaseResult => { released.push(`${dir} ${agent} ${session}`); return { ok: true, changed: true, dir, reason: "owner-released", ownerPid: PID }; },
		...extra };
}

test("SCRATCHBIN1: the recording session's end releases its dir as its own agent and session", () => {
	const released: string[] = [];
	expect(endSeat(RECORDED, PID, "S1", deps(stateRoot(), released))).toBe("released");
	expect(released).toEqual(["/seat/omp.4242 TurquoiseSummit S1"]);
});

test("SCRATCHBIN1 planted negative: a respawn in flight (matching marker) keeps the dir", () => {
	const root = stateRoot();
	plant(root, {});
	const released: string[] = [];
	expect(endSeat(RECORDED, PID, "S1", deps(root, released))).toBe("skipped-respawn");
	expect(released).toEqual([]);
});

test("SCRATCHBIN1 planted negatives: a marker of a reused pid, an expired marker or an unreadable start do not keep the dir", () => {
	for (const [row, extra] of [[{ start: "Mon Oct 12 00:00:00 2026" }, {}], [{ ttl_s: 30 }, {}], [{}, { startOf: () => null }]] as const) {
		const root = stateRoot();
		plant(root, row);
		const released: string[] = [];
		expect(endSeat(RECORDED, PID, "S1", deps(root, released, extra))).toBe("released");
		expect(released).toHaveLength(1);
	}
});

test("SCRATCHBIN1: a session that did not record the seat, or a seat never recorded, releases nothing", () => {
	const released: string[] = [];
	const live = deps(stateRoot(), released);
	expect(endSeat(RECORDED, PID, "SUBAGENT", live)).toBe("skipped-other-session");
	expect(endSeat(RECORDED, PID, undefined, live)).toBe("skipped-other-session");
	expect(endSeat({ dir: RECORDED.dir, agent: undefined, session: undefined }, PID, "S1", live)).toBe("skipped-not-recorded");
	expect(released).toEqual([]);
});

test("a refused release is reported by its reason and never throws", () => {
	const refusing = deps(stateRoot(), [], { release: (dir): ScratchReleaseResult => ({ ok: false, changed: false, dir, reason: "caller-not-owner", ownerPid: null }) });
	expect(endSeat(RECORDED, PID, "S1", refusing)).toBe("refused-caller-not-owner");
});
