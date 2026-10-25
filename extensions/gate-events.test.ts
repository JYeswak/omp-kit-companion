import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateEventsPath, gateFromReason, recordGateEvent, trackerAct } from "./gate-events";
import { ownedTmp } from "../src/kitlib/tmp.ts";

const base = ownedTmp("gate-events").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("trackerAct: the tracker acts the fleet measures, with their targets", () => {
	expect(trackerAct("br close ompkit-774u.1.3 --reason x")).toEqual({ act: "close", target: "ompkit-774u.1.3" });
	expect(trackerAct("cd x && br --db d update ompkit-fixjo --claim --actor y")).toEqual({ act: "claim", target: "ompkit-fixjo" });
	expect(trackerAct("AGENT_NAME=x br --db /p/beads.db update ompkit-fp72.135.3.1 --status in_review --actor z")).toEqual({ act: "in-review", target: "ompkit-fp72.135.3.1" });
	expect(trackerAct('br update ompkit-a1 --status open --assignee ""')).toEqual({ act: "release", target: "ompkit-a1" });
	expect(trackerAct("br create --title t")).toEqual({ act: "create", target: null });
});

test("trackerAct planted: words that are not an invocation are not acts", () => {
	for (const command of ["git commit -m close", "brew update x", "echo br close", "grep br close f", "br show ompkit-a1 --json"]) {
		expect(trackerAct(command)).toBeNull();
	}
});

test("gateFromReason: JSON code, prose code, and the guard name as fallback", () => {
	expect(gateFromReason(JSON.stringify({ guard: "kit-flywheel-guard", code: "CLAIM_REFUSED", refusal: {} }))).toBe("CLAIM_REFUSED");
	expect(gateFromReason("kit-flywheel-guard BEAD_LINT_REFUSED: `br update` would leave")).toBe("BEAD_LINT_REFUSED");
	expect(gateFromReason("[kit-agent-mail-guard] AM_IDENTITY_MISMATCH: y")).toBe("AM_IDENTITY_MISMATCH");
	expect(gateFromReason(JSON.stringify({ guard: "kit-flywheel-guard" }))).toBe("kit-flywheel-guard");
});

test("recordGateEvent appends one row per event under the state dir and never throws on a bad path", async () => {
	const env = { XDG_STATE_HOME: join(base, "state") };
	const path = gateEventsPath(env, base);
	expect(path).toBe(join(base, "state", "omp-kit", "gate-events.jsonl"));
	const first = await recordGateEvent({ seat: "PlumRaven", act: "close", target: "ompkit-a1", gate: "SELF_CLOSE_REFUSED", kind: "refuse", detail: "x" }, { env, home: base });
	const second = await recordGateEvent({ seat: "PlumRaven", act: "close", target: "ompkit-a1", gate: "flywheel", kind: "pass" }, { env, home: base });
	expect(first).toMatchObject({ ok: true, path });
	expect(second).toMatchObject({ ok: true, path });
	const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows.map(r => [r.act, r.gate, r.kind, r.target])).toEqual([["close", "SELF_CLOSE_REFUSED", "refuse", "ompkit-a1"], ["close", "flywheel", "pass", "ompkit-a1"]]);
	expect(rows.every(r => typeof r.ts === "string" && r.seat === "PlumRaven")).toBe(true);
	// planted: a path whose parent is a file is reported, not thrown; the good ledger is untouched
	writeFileSync(join(base, "not-a-dir"), "x");
	const bad = await recordGateEvent({ seat: null, act: "claim", target: null, gate: "x", kind: "refuse" }, { path: join(base, "not-a-dir", "gate-events.jsonl") });
	expect(bad.ok).toBe(false);
	expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
});
