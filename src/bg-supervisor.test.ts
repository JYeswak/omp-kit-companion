// bg-supervisor.test.ts — SUPERVISE1 (ompkit-fp72.19.1.27): the registry records
// every background agent (pid, parent seat, bead, task digest, checkpoint,
// deadline, policy); a killed agent restarts from its checkpoint; one that
// fails N times is reported, not looped; upgrade notices never reach a
// registered agent; results arrive as an inbox/aside event, never via polling.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyOnExit,
	decideOnExit,
	deregisterAgent,
	findAgent,
	loadRegistry,
	registerAgent,
	registryPath,
	resultEvent,
	saveRegistry,
	upgradeNoticeForAgent,
	validateRow,
	type BgAgentRow,
	type BgRegistry,
	type SuperviseDecision,
	type SuperviseEffects,
} from "./bg-supervisor.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function row(overrides: Partial<BgAgentRow> = {}): BgAgentRow {
	return {
		pid: 8601,
		parentSeat: "TurquoiseSummit",
		bead: "ompkit-fp72.19.1.27",
		taskDigest: DIGEST,
		checkpoint: "/tmp/bg-checkpoints/8601.json",
		deadline: "2026-10-20T00:00:00Z",
		restartPolicy: "restart",
		release: "0.2.58",
		attempts: 0,
		maxRestarts: 3,
		...overrides,
	};
}

function effects(): { calls: { kind: string; row: BgAgentRow }[]; api: SuperviseEffects } {
	const calls: { kind: string; row: BgAgentRow }[] = [];
	return {
		calls,
		api: {
			restart: (agent) => void calls.push({ kind: "restart", row: agent }),
			reassign: (agent) => void calls.push({ kind: "reassign", row: agent }),
			report: (agent) => void calls.push({ kind: "report", row: agent }),
		},
	};
}

test("registry records pid, parent seat, bead, task digest, checkpoint, deadline and policy", () => {
	const reg = registerAgent({ agents: [] }, row());
	expect(reg.agents.length).toBe(1);
	expect(reg.agents[0]).toEqual(row());
	expect(findAgent(reg, 8601)?.checkpoint).toBe("/tmp/bg-checkpoints/8601.json");
	expect(findAgent(reg, 9999)).toBeNull();
});

test("registry round-trips through the state file with every field intact", () => {
	const dir = mkdtempSync(join(tmpdir(), "bgsup-reg-"));
	try {
		const path = join(dir, "state", "bg-agents.json");
		saveRegistry(path, { agents: [row(), row({ pid: 8602, restartPolicy: "reassign" })] });
		const loaded = loadRegistry(path);
		expect(loaded.agents.length).toBe(2);
		expect(loaded.agents[0]).toEqual(row());
		expect(loaded.agents[1].restartPolicy).toBe("reassign");
		const raw = JSON.parse(readFileSync(path, "utf8")) as { agents: BgAgentRow[] };
		expect(raw.agents[0].taskDigest).toBe(DIGEST);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing registry file loads empty; malformed files refuse", () => {
	const dir = mkdtempSync(join(tmpdir(), "bgsup-missing-"));
	try {
		expect(loadRegistry(join(dir, "nope.json"))).toEqual({ agents: [] });
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "not json", "utf8");
		expect(() => loadRegistry(bad)).toThrow("not JSON");
		writeFileSync(bad, JSON.stringify({ agents: [{ pid: 1 }] }), "utf8");
		expect(() => loadRegistry(bad)).toThrow("refused");
		writeFileSync(bad, JSON.stringify({ agents: [row(), row()] }), "utf8");
		expect(() => loadRegistry(bad)).toThrow("duplicate pid 8601");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("planted: killed agent without result restarts from its checkpoint", () => {
	const seen = effects();
	const outcome = applyOnExit({ agents: [row()] }, 8601, { deliveredResult: false, cause: "killed" }, seen.api);
	expect(outcome.decision).toBe("restart-from-checkpoint");
	expect(outcome.effectRan).toBe(true);
	expect(seen.calls.length).toBe(1);
	expect(seen.calls[0].kind).toBe("restart");
	expect(seen.calls[0].row.checkpoint).toBe("/tmp/bg-checkpoints/8601.json");
	expect(seen.calls[0].row.taskDigest).toBe(DIGEST);
	expect(findAgent(outcome.registry, 8601)?.attempts).toBe(1);
});

test("planted: agent that failed maxRestarts times is reported, not looped", () => {
	const seen = effects();
	const reg: BgRegistry = { agents: [row({ attempts: 3, maxRestarts: 3 })] };
	expect(decideOnExit(reg, 8601, { deliveredResult: false, cause: "failed" }).decision).toBe("report-to-director");
	const outcome = applyOnExit(reg, 8601, { deliveredResult: false, cause: "failed" }, seen.api);
	expect(outcome.decision).toBe("report-to-director");
	expect(seen.calls.length).toBe(1);
	expect(seen.calls[0].kind).toBe("report");
	expect(seen.calls[0].row.parentSeat).toBe("TurquoiseSummit");
	expect(findAgent(outcome.registry, 8601)).toBeNull();
});

test("delivered result is done: deregistered, no restart effect", () => {
	const seen = effects();
	const outcome = applyOnExit({ agents: [row()] }, 8601, { deliveredResult: true, cause: "exited" }, seen.api);
	expect(outcome.decision).toBe("done");
	expect(outcome.effectRan).toBe(false);
	expect(seen.calls.length).toBe(0);
	expect(outcome.registry.agents.length).toBe(0);
});

test("reassign policy hands the checkpoint to another seat", () => {
	const seen = effects();
	const outcome = applyOnExit(
		{ agents: [row({ restartPolicy: "reassign" })] },
		8601,
		{ deliveredResult: false, cause: "upgrade-stopped" },
		seen.api,
	);
	expect(outcome.decision).toBe("reassign");
	expect(seen.calls[0].kind).toBe("reassign");
	expect(findAgent(outcome.registry, 8601)?.attempts).toBe(1);
});

test("report policy reports on first failure without consuming a restart", () => {
	const decided: SuperviseDecision[] = [];
	const outcome = applyOnExit(
		{ agents: [row({ restartPolicy: "report" })] },
		8601,
		{ deliveredResult: false, cause: "failed" },
		{
			restart: () => { throw new Error("must not restart"); },
			reassign: () => { throw new Error("must not reassign"); },
			report: (agent, decision) => void decided.push(decision),
		},
	);
	expect(outcome.decision).toBe("report-to-director");
	expect(decided).toEqual(["report-to-director"]);
	expect(outcome.registry.agents.length).toBe(0);
});

test("unknown pid runs no effect", () => {
	const seen = effects();
	const reg: BgRegistry = { agents: [row()] };
	const outcome = applyOnExit(reg, 1234, { deliveredResult: false, cause: "killed" }, seen.api);
	expect(outcome.decision).toBe("unknown-agent");
	expect(outcome.effectRan).toBe(false);
	expect(seen.calls.length).toBe(0);
	expect(outcome.registry).toBe(reg);
});

test("upgrade notice is held for a registered agent; it finishes on its starting release", () => {
	const reg: BgRegistry = { agents: [row({ release: "0.2.58" })] };
	const hold = upgradeNoticeForAgent(reg, 8601);
	expect(hold.verdict).toBe("held");
	expect(hold.release).toBe("0.2.58");
	expect(upgradeNoticeForAgent(reg, 1234)).toEqual({ verdict: "unknown-agent", release: null });
});

test("result arrives as an aside event to the parent seat (no wait, no poll)", () => {
	const event = resultEvent(row(), "round 4 of 4 complete");
	expect(event.to).toBe("TurquoiseSummit");
	expect(event.deliverAs).toBe("aside");
	expect(event.subject).toContain("ompkit-fp72.19.1.27");
	expect(event.body).toContain("round 4 of 4 complete");
	expect(event.body).toContain("/tmp/bg-checkpoints/8601.json");
	expect(() => resultEvent(row(), "  ")).toThrow("refused");
});

test("invalid rows refuse: empty, relative checkpoint, bad policy, bad pid, bad digest", () => {
	expect(() => validateRow(null)).toThrow("refused");
	expect(() => validateRow(row({ checkpoint: "" }))).toThrow("checkpoint");
	expect(() => validateRow(row({ checkpoint: "relative/path.json" }))).toThrow("absolute");
	expect(() => validateRow({ ...row(), restartPolicy: "retry" })).toThrow("restartPolicy");
	expect(() => validateRow(row({ pid: 0 }))).toThrow("pid");
	expect(() => validateRow(row({ taskDigest: "short" }))).toThrow("taskDigest");
	expect(() => validateRow(row({ attempts: 4, maxRestarts: 3 }))).toThrow("attempts");
	expect(() => registerAgent({ agents: [row()] }, row())).toThrow("already registered");
	expect(deregisterAgent({ agents: [row()] }, 8601)).toEqual({ agents: [] });
});

test("registryPath honors XDG_STATE_HOME and defaults to ~/.local/state", () => {
	expect(registryPath({ XDG_STATE_HOME: "/xdg" }, "/home/u")).toBe("/xdg/omp-kit-orchestration/bg-agents.json");
	expect(registryPath({}, "/home/u")).toBe("/home/u/.local/state/omp-kit-orchestration/bg-agents.json");
});
