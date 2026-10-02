import { check as checkGit } from "../src/fleet-guard/git.ts";
import { check as checkReservations } from "../src/fleet-guard/reservations.ts";
import { applyScratchEnv, check as checkScratch, scratchDirFor, writeScratchOwner, type FleetGuardBlock, type FleetGuardContext, type FleetGuardEvent } from "../src/fleet-guard/scratch.ts";

/**
 * fleet-guard: force the fleet rules inside the session instead of asking.
 * Scratch goes to the repo-local var/agent-tmp (never /tmp), writes outside it
 * are blocked, work happens on main, and tracked edits need an Agent Mail
 * reservation. Shipped in the plugin; installed per profile by the kit.
 */

interface ExtensionApi {
	setLabel(label: string): void;
	on(event: "tool_call", handler: (event: FleetGuardEvent) => Promise<FleetGuardBlock | undefined>): void;
}

export interface GuardDeps {
	cwd?: string;
	pid?: number;
}

/** Ordered chain: scratch, then git, then reservations. First block wins. */
export async function handleToolCall(event: FleetGuardEvent, context: FleetGuardContext): Promise<FleetGuardBlock | undefined> {
	const reservations = { cwd: context.cwd, agentName: context.agentName,
		isTrackedPath: context.isTrackedPath, lookupReservations: context.lookupReservations, warn: context.warn };
	return checkScratch(event, context) ?? checkGit(event, context) ?? await checkReservations(event, reservations) ?? undefined;
}
export default async function fleetGuard(pi: ExtensionApi, deps?: GuardDeps): Promise<void> {
	const cwd = deps?.cwd ?? process.cwd();
	const pid = deps?.pid ?? process.pid;
	const dir = scratchDirFor(cwd, pid);
	writeScratchOwner(dir, { pid, label: "omp", repo: dir.split("/var/agent-tmp/")[0] ?? cwd,
		created: new Date().toISOString() });
	applyScratchEnv(dir);
	pi.setLabel("fleet-guard");
	pi.on("tool_call", async event => handleToolCall(event, { cwd }));
}
