/** HEALTH1 session gate (bead ompkit-fp72.11): unit tests for src/session-health.ts.
 *
 * stale_user_warns_and_proceeds (planted 2026-10-11 incident shape),
 * dead_orchestrator_blocks, unreachable_worker_blocks_while_dead_shell_warns,
 * all_healthy_passes_and_no_agent_pane_blocks (fail closed).
 */
import { expect, test } from "bun:test";
import {
	reconcileSessionHealth,
	type SessionPane,
} from "./session-health.ts";

const liveAgents = (over: Partial<SessionPane>[]): SessionPane[] =>
	over.map((pane, index) => ({ role: "worker", status: "healthy", ...pane, label: pane.label ?? `%${17 + index}` }));

// HEALTH1 planted negative: the 2026-10-11 incident. A stale user pane with
// healthy agent panes warns and proceeds, never blocks INTEGRATE.
test("stale user pane with healthy agent panes warns and proceeds", () => {
	const health = reconcileSessionHealth([
		{ role: "user", status: "healthy", label: "%16" },
		{ role: "user", status: "stale", label: "%18" },
		...liveAgents([{ role: "orchestrator" }, {}]),
	]);
	expect(health.verdict).toBe("WARN");
	expect(health.proceed).toBe(true);
});

// HEALTH1 planted negative: a dead orchestrator pane blocks INTEGRATE.
test("dead orchestrator pane blocks even beside a stale user pane", () => {
	const health = reconcileSessionHealth([
		{ role: "user", status: "stale", label: "%18" },
		...liveAgents([{ role: "orchestrator", status: "dead", label: "%17" }, {}]),
	]);
	expect(health.verdict).toBe("BLOCK");
	expect(health.proceed).toBe(false);
	expect(health.reason).toContain("%17");
});

// Boundary: an unreachable worker blocks; a dead shell pane never does.
test("unreachable worker blocks while a dead shell pane only warns", () => {
	const blocked = reconcileSessionHealth([
		{ role: "shell", status: "dead", label: "%9" },
		...liveAgents([{ status: "unreachable", label: "%21" }]),
	]);
	expect(blocked.verdict).toBe("BLOCK");
	expect(blocked.proceed).toBe(false);
	const warned = reconcileSessionHealth([
		{ role: "shell", status: "dead", label: "%9" },
		...liveAgents([{}]),
	]);
	expect(warned.verdict).toBe("WARN");
	expect(warned.proceed).toBe(true);
});

// Boundary: all healthy passes; no agent pane observed fails closed.
test("all healthy panes pass; no agent pane blocks", () => {
	const pass = reconcileSessionHealth([
		{ role: "user", status: "healthy", label: "%16" },
		...liveAgents([{ role: "orchestrator" }, {}]),
	]);
	expect(pass.verdict).toBe("PASS");
	expect(pass.proceed).toBe(true);
	const blind = reconcileSessionHealth([{ role: "user", status: "healthy", label: "%16" }]);
	expect(blind.verdict).toBe("BLOCK");
	expect(blind.proceed).toBe(false);
});
