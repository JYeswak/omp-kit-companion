import { resolve } from "node:path";
import { check as checkGit } from "../src/fleet-guard/git.ts";
import { check as checkReservations, exportAgentMailStorageRoot } from "../src/fleet-guard/reservations.ts";
import { applyScratchEnv, check as checkScratch, scratchDirFor, writeScratchOwner, type FleetGuardBlock, type FleetGuardContext, type FleetGuardEvent } from "../src/fleet-guard/scratch.ts";
import { check as checkDurability } from "../src/fleet-guard/durability.ts";
import { fleetPolicyState } from "./fleet-policy.ts";

/**
 * fleet-guard: force the fleet rules inside the session instead of asking.
 * Scratch goes to the repo-local var/agent-tmp (never /tmp), writes outside it
 * are blocked, work happens on main, and tracked edits need an Agent Mail
 * reservation. Shipped in the plugin; installed per profile by the kit.
 */

interface ToolCallContext {
	cwd: string;
	localProtocolOptions?: { getArtifactsDir?: () => string | null };
}

interface ExtensionApi {
	setLabel(label: string): void;
	on(event: "tool_call", handler: (event: FleetGuardEvent, context?: ToolCallContext) => Promise<FleetGuardBlock | undefined>): void;
}

export interface GuardDeps {
	cwd?: string;
	pid?: number;
}

/** Ordered chain: lexical scratch, Git, repository facts, then reservations. First block wins. */
export async function handleToolCall(event: FleetGuardEvent, context: FleetGuardContext): Promise<FleetGuardBlock | undefined> {
	const reservations = { cwd: context.cwd, agentName: context.agentName,
		isTrackedPath: context.isTrackedPath, lookupReservations: context.lookupReservations, warn: context.warn };
	return checkScratch(event, context) ?? checkGit(event, context) ?? await checkDurability(event, context) ??
		await checkReservations(event, reservations) ?? undefined;
}
export default async function fleetGuard(pi: ExtensionApi, deps?: GuardDeps): Promise<void> {
	const cwd = deps?.cwd ?? process.cwd();
	const pid = deps?.pid ?? process.pid;
	const initial = await fleetPolicyState(cwd);
	if (initial.kind === "off") return;
	if (initial.kind === "on") {
		const dir = scratchDirFor(initial.root, pid);
		writeScratchOwner(dir, { pid, label: "omp", repo: initial.root, created: new Date().toISOString() });
		applyScratchEnv(dir);
		try { await exportAgentMailStorageRoot(); }
		catch {
			console.warn("fleet-guard: Agent Mail storage-root discovery unavailable; reservation admission reports storage failures separately");
		}
	}
	pi.setLabel("fleet-guard");
	pi.on("tool_call", async (event, context) => {
		const callingCwd = context?.cwd ?? cwd;
		const policy = await fleetPolicyState(callingCwd);
		if (policy.kind === "off") return undefined;
		if (policy.kind === "unavailable") return { block: true, reason: `fleet-guard applicability: ${policy.reason}` };
		// OMP supplies the calling session's mapping (including subagent sharing).
		// No cwd/default-session guess: an absent backing root fails closed for local://.
		const artifactsDir = context?.localProtocolOptions?.getArtifactsDir?.();
		return handleToolCall(event, { cwd: callingCwd,
			localRoot: artifactsDir ? resolve(artifactsDir, "local") : undefined });
	});
}
